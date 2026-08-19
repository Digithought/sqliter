import { expect } from 'chai';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { Database } from '../../src/index.js';
import type { WorkCounterSnapshot } from '../../src/index.js';
import {
	STABILITY_CASES,
	TABLE_ROW_COUNT,
	collectSnapshots,
	setupDatabase,
	snapshotStatement,
} from './work-counter-stability-shared.js';

/**
 * Acceptance tests for the work-counter surface (Statement.getWorkCounters):
 * the whole point of counting work instead of timing it is that the counts are
 * IDENTICAL across executions, databases, and processes. Each stability leg
 * attacks one way that identity could break — chiefly a process-global
 * `PlanNode.id` leaking into a counter key, which the different-warmup legs
 * would catch immediately (warmups burn plan-node ids, shifting every
 * subsequently-compiled plan's ids between the two runs being compared).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/runtime -> test -> packages/quereus -> packages -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const CHILD_PATH = join(__dirname, 'work-counter-stability-child.ts');

interface ChildReport {
	ok: boolean;
	snapshots?: Record<string, WorkCounterSnapshot>;
	error?: string;
}

/**
 * Fork the child runner with a warmup count and collect its IPC report.
 * cwd MUST be the repo root: register.mjs resolves TS_NODE_PROJECT relative to
 * the working directory.
 */
function runChild(warmup: number): Promise<Record<string, WorkCounterSnapshot>> {
	return new Promise((resolve, reject) => {
		const child = fork(CHILD_PATH, [String(warmup)], {
			cwd: REPO_ROOT,
			execArgv: ['--import', pathToFileURL(join(REPO_ROOT, 'packages/quereus/register.mjs')).href],
			stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
		});
		let report: ChildReport | undefined;
		child.on('message', (message) => {
			report = message as ChildReport;
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (!report) {
				reject(new Error(`child (warmup=${warmup}) exited with code ${code} without reporting`));
			} else if (!report.ok) {
				reject(new Error(`child (warmup=${warmup}) failed: ${report.error}`));
			} else {
				resolve(report.snapshots!);
			}
		});
	});
}

describe('work-counter stability', () => {
	it('two executions of one prepared statement count identically', async () => {
		const db = await setupDatabase();
		try {
			for (const stabilityCase of STABILITY_CASES) {
				const stmt = db.prepare(stabilityCase.sql);
				try {
					for await (const _ of stmt.all()) { /* drain */ }
					const first = stmt.getWorkCounters();
					for await (const _ of stmt.all()) { /* drain */ }
					const second = stmt.getWorkCounters();
					expect(first, stabilityCase.name).to.not.equal(undefined);
					expect(second, stabilityCase.name).to.deep.equal(first);
				} finally {
					await stmt.finalize();
				}
			}
		} finally {
			await db.close();
		}
	});

	it('two fresh databases in one process count identically despite different plan-node id offsets', async function () {
		this.timeout(30000);
		const a = await collectSnapshots(0);
		const b = await collectSnapshots(7);
		expect(b).to.deep.equal(a);
	});

	it('two separate processes count identically', async function () {
		this.timeout(180000);
		const a = await runChild(3);
		const b = await runChild(11);
		expect(Object.keys(a)).to.have.members(STABILITY_CASES.map((c) => c.name));
		expect(b).to.deep.equal(a);
	});

	it('snapshots survive a JSON round-trip unchanged (no bigint, no non-JSON values)', async () => {
		const snapshots = await collectSnapshots(0);
		for (const [name, snapshot] of Object.entries(snapshots)) {
			expect(JSON.parse(JSON.stringify(snapshot)), name).to.deep.equal(snapshot);
		}
	});

	it('returns undefined when runtime metrics are off', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (a integer primary key, b integer)');
			await db.exec('insert into t values (1, 10)');
			const stmt = db.prepare('select a from t');
			try {
				for await (const _ of stmt.all()) { /* drain */ }
				expect(stmt.getWorkCounters()).to.equal(undefined);
			} finally {
				await stmt.finalize();
			}
		} finally {
			await db.close();
		}
	});

	it('a zero-row execution still reports the work it did', async () => {
		const db = await setupDatabase();
		try {
			const snapshot = await snapshotStatement(db, 'select a from t where a > 1000');
			expect(snapshot.totals.instructionExecutions).to.be.greaterThan(0);
			// The snapshot omits instructions that never ran, so an entry with
			// out === 0 proves executed-but-produced-nothing is representable.
			expect(snapshot.instructions.some((i) => i.out === 0)).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('makes N+1 sub-program work visible', async () => {
		const db = await setupDatabase();
		try {
			const correlated = STABILITY_CASES.find((c) => c.name === 'correlated-subquery')!;
			const snapshot = await snapshotStatement(db, correlated.sql);
			// The correlated scalar subquery compiles to a sub-program driven once
			// per outer row: its instructions key under `r/...` and report
			// TABLE_ROW_COUNT executions — the shape of an N+1 regression.
			const subProgram = snapshot.instructions.filter((i) => i.key.startsWith('r/'));
			expect(subProgram).to.not.have.length(0);
			expect(snapshot.instructions.some((i) => i.executions >= TABLE_ROW_COUNT)).to.equal(true);
		} finally {
			await db.close();
		}
	});
});
