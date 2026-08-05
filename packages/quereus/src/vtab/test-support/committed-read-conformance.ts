import type { Database } from '../../core/database.js';
import type { SqlValue } from '../../common/types.js';
import { PlanNode } from '../../planner/nodes/plan-node.js';
import { TableReferenceNode } from '../../planner/nodes/reference.js';
import { getModuleReadCommittedSnapshot } from '../concurrency.js';

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

/** Handle returned by {@link CommittedReadConformanceOptions.stallCommit}. */
export interface CommitStallHandle {
	/**
	 * Optional. Resolves once a commit has actually ENTERED the stall. Supply it
	 * when your gate can tell — the harness then waits for the writer to be
	 * provably parked before reading, instead of guessing with a settle window.
	 */
	readonly entered?: Promise<void>;
	/** Release the gate so the parked commit (and any later one) proceeds. Must be idempotent. */
	release(): void;
}

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

/** Reject after `ms` with a message that names the likely cause. */
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
 *  6. release, await the writer, and assert a fresh read now sees the post-write
 *     state (so a module that serves permanently stale data fails too).
 *
 * @throws Error with the specific divergence on any failure.
 */
export async function runCommittedReadConformance(
	options: CommittedReadConformanceOptions,
): Promise<CommittedReadConformanceResult> {
	const {
		db,
		table,
		keyColumn,
		valueColumn,
		stallCommit,
		rowCount = 200,
		stallTimeoutMs = 5000,
	} = options;

	if (!Number.isInteger(rowCount) || rowCount < 2) {
		throw new Error(`committed-read conformance: rowCount must be an integer >= 2, got ${rowCount}`);
	}

	assertModuleDeclaresSnapshot(db, table);

	const projection = `select ${keyColumn} as ${KEY_ALIAS}, ${valueColumn} as ${VALUE_ALIAS} from ${table}`;
	const existing = await collectSnapshot(db, projection);
	if (existing.length > 0) {
		throw new Error(
			`committed-read conformance: '${table}' must be empty on entry (found ${existing.length} rows). ` +
			`The harness owns the table's contents for the run and deletes what it wrote on the way out.`,
		);
	}

	// Seeded band is 1..rowCount; the writer appends rowCount+1..highKey.
	const appendCount = Math.max(1, Math.floor(rowCount / 10));
	const highKey = rowCount + appendCount;
	const seedKeys = Array.from({ length: rowCount }, (_, i) => i + 1);
	const expectedPre: SnapshotRow[] = seedKeys.map(k => ({ key: String(k), value: seedValue(k) }));
	const expectedPost: SnapshotRow[] = Array.from(
		{ length: highKey },
		(_, i) => ({ key: String(i + 1), value: postValue(i + 1) }),
	);

	const tuples = (keys: number[], value: (k: number) => string) =>
		keys.map(k => `(${k}, '${value(k)}')`).join(', ');

	await db.exec(`insert into ${table} (${keyColumn}, ${valueColumn}) values ${tuples(seedKeys, seedValue)}`);

	// A single statement, so it commits once: `or replace` rewrites every seeded
	// row's value AND appends new keys. A torn publish therefore shows up two
	// ways — as a mix of old and new values, and as a longer result set.
	const writerKeys = Array.from({ length: highKey }, (_, i) => i + 1);
	const writerSql =
		`insert or replace into ${table} (${keyColumn}, ${valueColumn}) values ${tuples(writerKeys, postValue)}`;

	// Both legs project identically; only the predicate differs. The range covers
	// the appended keys too, so an index-driven read of a torn publish is short or
	// long in exactly the way the full scan is.
	const fullScanSql = projection;
	const indexDrivenSql = `${projection} where ${keyColumn} >= 1 and ${keyColumn} <= ${highKey}`;

	// Probe the plan BEFORE anything parks — `query_plan()` is an ordinary
	// statement and would queue behind the stalled writer.
	const indexOps = await planOperators(db, indexDrivenSql);
	const indexSeekPlanned = indexOps.includes('INDEXSEEK');
	const indexDrivenSkippedReason = indexSeekPlanned
		? undefined
		: `the planner did not choose a seek for a range predicate on '${keyColumn}' (plan operators: ${indexOps.join(', ')}); ` +
		  `the index-driven leg was skipped rather than run as a second full scan`;

	const handle = stallCommit?.();
	let writerSettled = false;
	const writer = db.exec(writerSql);
	const trackedWriter = writer.then(
		() => { writerSettled = true; },
		error => { writerSettled = true; throw error; },
	);
	// Keep an unhandled rejection from escaping before the awaited read below.
	trackedWriter.catch(() => { /* re-thrown at the awaited join */ });

	let fullScan: SnapshotRow[] = [];
	let indexDriven: SnapshotRow[] = [];
	let parkedForReads = false;
	let readError: unknown;

	try {
		if (handle) {
			if (handle.entered) {
				// Deterministic: proceed once a commit is provably inside the gate. If
				// the writer finished first there was no window at all.
				await Promise.race([handle.entered, trackedWriter]);
			} else {
				await settleWindow();
			}
		}
		parkedForReads = handle !== undefined && !writerSettled;

		const guard = <T>(work: Promise<T>, what: string): Promise<T> =>
			parkedForReads ? withStallTimeout(work, stallTimeoutMs, what) : work;

		fullScan = await guard(collectSnapshot(db, fullScanSql, { readCommitted: true }), 'the full-scan read');
		if (indexSeekPlanned) {
			indexDriven = await guard(
				collectSnapshot(db, indexDrivenSql, { readCommitted: true }),
				'the index-driven read',
			);
		}
		if (parkedForReads && writerSettled) {
			// The writer landed while we were reading, so neither read is evidence of
			// anything: the "committed snapshot" they saw may simply be the new state.
			parkedForReads = false;
		}

		// Parked: the commit provably had NOT landed, so the pre-write snapshot is the
		// only correct answer. Not parked: the writer may have committed before either
		// read began, and serving the post-write state is then equally correct — so
		// accept either whole state, but never a mix of the two (that is a tear no
		// interleaving excuses).
		const acceptable = parkedForReads ? [expectedPre] : [expectedPre, expectedPost];
		assertCoherent('full scan', fullScan, acceptable, valueColumn, parkedForReads);
		if (indexSeekPlanned) {
			assertCoherent('index-driven read', indexDriven, acceptable, valueColumn, parkedForReads);
			// Only meaningful while the writer is parked: unparked, the two legs run at
			// different times and may legitimately straddle the commit.
			if (parkedForReads) assertLegsAgree(fullScan, indexDriven);
		}
	} catch (e) {
		readError = e;
	}

	handle?.release();
	try {
		await trackedWriter;
	} catch (e) {
		if (readError === undefined) readError = e;
	}

	if (readError === undefined) {
		try {
			await assertAdvancesAfterCommit(db, projection, highKey, rowCount);
		} catch (e) {
			readError = e;
		}
	}

	await cleanup(db, table, readError);

	if (readError !== undefined) throw readError;

	return {
		observedCommitOverlap: parkedForReads,
		fullScanRows: fullScan.length,
		indexDrivenRows: indexDriven.length,
		...(indexDrivenSkippedReason !== undefined ? { indexDrivenSkippedReason } : {}),
	};
}

/** Give a pending commit a fair chance to reach the gate across several macrotasks. */
async function settleWindow(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
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
 * check above. After the writer lands, a fresh read must see the new state.
 */
async function assertAdvancesAfterCommit(
	db: Database,
	projection: string,
	highKey: number,
	rowCount: number,
): Promise<void> {
	const after = await collectSnapshot(db, projection);
	if (after.length !== highKey) {
		throw new Error(
			`committed-read conformance: after the writer committed, a fresh read returned ${after.length} rows, expected ${highKey}. ` +
			`The module is serving a stale snapshot to ordinary reads.`,
		);
	}
	const stale = after.filter(row => row.value !== postValue(Number(row.key)));
	if (stale.length > 0) {
		throw new Error(
			`committed-read conformance: after the writer committed, ${stale.length} of ${after.length} rows still held their pre-write value ` +
			`(first: key ${stale[0].key} = ${JSON.stringify(stale[0].value)}). A pinned snapshot must advance once the commit lands ` +
			`— seeding was ${rowCount} rows.`,
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
