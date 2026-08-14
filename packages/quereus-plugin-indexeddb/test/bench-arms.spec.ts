/**
 * Correctness smoke test for the IndexedDB index-resolution benchmark arms.
 *
 * The harness in `bench/arms.mjs` exists to produce TIMINGS in a real browser. Timings are
 * only worth reading if every arm returns the same rows, so this spec pins exactly that:
 * each arm's result set against an independently computed oracle, and the arms against each
 * other, across both layouts, both clusterings, several selectivities, and page sizes chosen
 * to split a run of equal secondary values.
 *
 * It runs under `fake-indexeddb`, which says NOTHING about how fast a real engine is —
 * no timing or request-count assertion belongs here. Row sets only.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import {
	armA,
	armB,
	armB2,
	armC,
	armD,
	armEUpdateNative,
	armEUpdateTwoStore,
	buildDataset,
	deleteDb,
	expectedOrdinals,
	makeEnv,
	probeBinaryIndexKeys,
	RUN,
	seedNative,
	seedTwoStore,
	updateSample,
} from '../bench/arms.mjs';

const env = makeEnv();

/** Small enough that fake-indexeddb stays fast; big enough to span many pages. */
const ROW_COUNT = 600;

/** Per-test unique database name — a counter, so names stay stable and collision-free. */
let seq = 0;
const nextDbName = (): string => `quereus-bench-smoke-${seq++}`;

const sorted = (ordinals: number[]): number[] => [...ordinals].sort((a, b) => a - b);

/** Result shape every arm returns. Declared here because `arms.mjs` is untyped JavaScript. */
interface ArmResult {
	ordinals: number[];
	ms: number;
	requests: number;
	transactions: number;
	spanRows?: number;
}

/** Seed a layout, hand its connection to `body`, then close and DELETE the database.
 *  Deleting is not tidiness: `deleteDb` rejects while a connection is open, and a layout left
 *  behind would be re-opened at the wrong version by the next case. */
async function withLayout<T>(
	seed: (dbName: string) => Promise<{ db: IDBDatabase }>,
	body: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
	const dbName = nextDbName();
	const { db } = await seed(dbName);
	try {
		return await body(db);
	} finally {
		db.close();
		await deleteDb(env, dbName);
	}
}

/** Both a set check and a multiplicity check: a repeated row survives set equality alone. */
function expectSameRows(actual: number[], expected: number[], label: string): void {
	expect(new Set(actual).size, `${label}: returned a row more than once`).to.equal(actual.length);
	expect(sorted(actual), `${label}: wrong row set`).to.deep.equal(sorted(expected));
}

describe('IndexedDB native-index benchmark arms', () => {
	const CASES: Array<{ clustering: 'clustered' | 'uniform'; k: number; pageSize: number }> = [];
	for (const clustering of ['clustered', 'uniform'] as const) {
		for (const k of [1, 13, ROW_COUNT / RUN]) {
			// 256 is the production page size; 7 and 10 are deliberately NOT multiples of RUN,
			// so a page boundary lands INSIDE a run of equal secondary values — the case arm B's
			// resume edge (last record's unique index key) exists to survive.
			for (const pageSize of [256, 7, 10]) {
				CASES.push({ clustering, k, pageSize });
			}
		}
	}

	it('the engine under test accepts binary index keys', async () => {
		// Every native-layout arm is vacuous without this, so fail loudly rather than
		// silently measuring nothing.
		const probe = await probeBinaryIndexKeys(env, nextDbName());
		expect(probe.reason ?? 'ok').to.equal('ok');
		expect(probe.supported).to.equal(true);
	});

	for (const { clustering, k, pageSize } of CASES) {
		const label = `${clustering}, k=${k} (${k * RUN} rows), page=${pageSize}`;

		it(`every arm returns the same rows: ${label}`, async () => {
			const dataset = buildDataset({ rowCount: ROW_COUNT, clustering });
			const expected = expectedOrdinals(dataset, k);
			expect(expected).to.have.length(k * RUN);

			const [a, c, d] = await withLayout(
				(name) => seedTwoStore(env, name, dataset),
				async (db): Promise<ArmResult[]> => [
					await armA(env, db, { k, pageSize }),
					await armC(env, db, { k, pageSize }),
					await armD(env, db, { k, pageSize }),
				],
			);
			const [b, b2] = await withLayout(
				(name) => seedNative(env, name, dataset),
				async (db): Promise<ArmResult[]> => [
					await armB(env, db, { k, pageSize }),
					await armB2(env, db, { k, pageSize }),
				],
			);

			expectSameRows(a.ordinals, expected, 'arm A (current path)');
			expectSameRows(b.ordinals, expected, 'arm B (native index)');
			expectSameRows(b2.ordinals, expected, 'arm B2 (native entries only)');
			expectSameRows(c.ordinals, expected, 'arm C (full scan + filter)');
			expectSameRows(d.ordinals, expected, 'arm D (span getAll + set filter)');

			// Arm D reads at least the rows it returns; on a clustered spread it should read
			// barely more, which is the property that makes the arm interesting at all.
			expect(d.spanRows).to.be.at.least(expected.length);
		});
	}

	it('arm B keeps index order, so its resume edge cannot reorder rows across pages', async () => {
		// Index order is by (secondary value, primary key). Within a run of equal secondary
		// values that reduces to primary-key order, so the whole result is ascending under
		// clustered ranks — a resume edge that skipped or rewound would break monotonicity.
		const dataset = buildDataset({ rowCount: ROW_COUNT, clustering: 'clustered' });
		const b: ArmResult = await withLayout(
			(name) => seedNative(env, name, dataset),
			(db) => armB(env, db, { k: 40, pageSize: 7 }),
		);
		expect(b.ordinals).to.deep.equal(sorted(b.ordinals));
		expect(b.ordinals).to.have.length(40 * RUN);
	});

	it('a page boundary inside a run of equal secondary values neither skips nor repeats', async () => {
		// RUN rows share each secondary value; a page size coprime with RUN guarantees that
		// most page boundaries fall mid-run. Sweeping page sizes 1..9 covers every offset a
		// boundary can take within a run.
		const dataset = buildDataset({ rowCount: 200, clustering: 'uniform' });
		const k = 11;
		const expected = expectedOrdinals(dataset, k);
		await withLayout(
			(name) => seedNative(env, name, dataset),
			async (db) => {
				for (let pageSize = 1; pageSize <= 9; pageSize++) {
					const b: ArmResult = await armB(env, db, { k, pageSize });
					expectSameRows(b.ordinals, expected, `arm B at page=${pageSize}`);
				}
			},
		);
	});

	it('an empty result set costs no paging and returns nothing', async () => {
		const dataset = buildDataset({ rowCount: 120, clustering: 'clustered' });
		await withLayout(
			(name) => seedTwoStore(env, name, dataset),
			async (db) => {
				// k = 0 selects no secondary value at all: the bounds collapse to an empty range,
				// which `IDBKeyRange.bound` would reject with DataError if it were ever built.
				const a: ArmResult = await armA(env, db, { k: 0 });
				const d: ArmResult = await armD(env, db, { k: 0 });
				expect(a.ordinals).to.deep.equal([]);
				expect(d.ordinals).to.deep.equal([]);
				expect(a.requests).to.equal(0);
				expect(d.requests).to.equal(0);
			},
		);
	});

	describe('arm E (write side)', () => {
		it('both layouts still answer identically after the indexed value changes', async () => {
			// The write arms are timed, not asserted, in the browser — but a write path that
			// leaves the two layouts disagreeing would make those timings a comparison of
			// different work. This pins that they do the same thing.
			const dataset = buildDataset({ rowCount: ROW_COUNT, clustering: 'uniform' });
			const ordinals = updateSample(dataset, 60);
			const shifted = new Set(ordinals);
			const valueShift = ROW_COUNT; // pushes every touched row above every original value
			const k = ROW_COUNT / RUN; // "all original values" — the shifted rows drop out

			const a: ArmResult = await withLayout(
				(name) => seedTwoStore(env, name, dataset),
				async (db) => {
					const write = await armEUpdateTwoStore(env, db, dataset, { ordinals, valueShift });
					expect(write.rows).to.equal(ordinals.length);
					return armA(env, db, { k });
				},
			);
			const b: ArmResult = await withLayout(
				(name) => seedNative(env, name, dataset),
				async (db) => {
					await armEUpdateNative(env, db, dataset, { ordinals, valueShift });
					return armB(env, db, { k });
				},
			);

			const expected = dataset.rows
				.filter((row) => !shifted.has(row.ordinal) && row.secondary < k)
				.map((row) => row.ordinal);
			expect(expected).to.have.length(ROW_COUNT - ordinals.length);
			expectSameRows(a.ordinals, expected, 'arm A after two-store updates');
			expectSameRows(b.ordinals, expected, 'arm B after native updates');
		});
	});
});
