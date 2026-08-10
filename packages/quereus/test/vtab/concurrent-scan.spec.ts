import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { MemoryTable } from '../../src/vtab/memory/table.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { Row } from '../../src/common/types.js';
import { INTEGER_TYPE } from '../../src/types/index.js';

/**
 * Direct vtab-layer concurrency test for the memory table.
 *
 * Unlike concurrency-mode.spec.ts's "concurrent scan smoke" (which drives
 * `db.eval()` and is therefore serialized by the engine's per-call exec
 * mutex), this suite calls `MemoryTable.query()` directly and manually
 * interleaves `.next()` pulls across several iterators over a SINGLE
 * connection. That overlap is exactly what the parallel runtime's
 * ParallelDriver will do via FanOutLookupJoinNode, so it genuinely exercises
 * the `reentrant-reads` concurrency contract that MemoryTableModule declares.
 */

const COLUMNS: ColumnSchema[] = [
	{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
	{ name: 'v', logicalType: INTEGER_TYPE, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
];

function createTableSchema(name: string, module: MemoryTableModule): TableSchema {
	const columnIndexMap = new Map(COLUMNS.map((col, idx) => [col.name, idx]));
	return {
		vtabModuleName: 'memory',
		schemaName: 'main',
		name,
		columns: Object.freeze(COLUMNS),
		columnIndexMap,
		primaryKeyDefinition: Object.freeze([{ index: 0, desc: false }]),
		indexes: Object.freeze([]),
		checkConstraints: Object.freeze([]),
		vtabModule: module,
		isView: false,
	};
}

/** Full-table-scan FilterInfo (no constraints, no ordering). */
function fullScanFilter(): FilterInfo {
	return {
		idxNum: 0,
		idxStr: 'full_scan',
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: 0n,
			aConstraintUsage: [],
			idxNum: 0,
			idxStr: '',
			orderByConsumed: false,
			estimatedCost: 0,
			estimatedRows: 0n,
			idxFlags: 0,
		},
	};
}

async function seed(table: MemoryTable, rowCount: number): Promise<void> {
	for (let i = 0; i < rowCount; i++) {
		const result = await table.update({ operation: 'insert', values: [i, i * 2] });
		expect(result.status).to.equal('ok');
	}
}

describe('memory vtab direct concurrent scan', () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(() => {
		db = new Database();
		module = new MemoryTableModule();
	});

	afterEach(async () => {
		await db.close();
	});

	it('round-robins N overlapping iterators over one connection without corruption', async () => {
		const ROW_COUNT = 50;
		const N = 4;
		const table = await module.create(db, createTableSchema('overlap', module));
		await seed(table, ROW_COUNT);

		// Obtain N independent AsyncIterators over the same table/connection.
		// query() returns a fresh async generator each call; capturing the
		// iterator with [Symbol.asyncIterator]() lets us drive .next() ourselves.
		const iterators = Array.from({ length: N }, () =>
			table.query(fullScanFilter())[Symbol.asyncIterator]());

		const collected: Row[][] = Array.from({ length: N }, () => []);
		const done = new Array<boolean>(N).fill(false);

		// Round-robin a single .next() across every live iterator per round. No
		// iterator is drained before the others advance, so the scans genuinely
		// overlap at the vtab layer. Determinism comes purely from the pull
		// ordering — no timers.
		let remaining = N;
		while (remaining > 0) {
			for (let i = 0; i < N; i++) {
				if (done[i]) continue;
				const { value, done: isDone } = await iterators[i].next();
				if (isDone) {
					done[i] = true;
					remaining--;
				} else {
					collected[i].push(value);
				}
			}
		}

		for (let i = 0; i < N; i++) {
			expect(collected[i], `iterator ${i} cardinality`).to.have.length(ROW_COUNT);
			// Rows are PK-ordered; verify shape and ordering, no dup/loss.
			for (let r = 0; r < ROW_COUNT; r++) {
				const row = collected[i][r];
				expect(row, `iterator ${i} row ${r} shape`).to.have.length(2);
				expect(row[0], `iterator ${i} row ${r} id`).to.equal(r);
				expect(row[1], `iterator ${i} row ${r} v`).to.equal(r * 2);
			}
		}
	});

	it('an in-flight scan keeps its start-of-call snapshot across an intervening write', async () => {
		const ROW_COUNT = 20;
		const table = await module.create(db, createTableSchema('snapshot', module));
		await seed(table, ROW_COUNT);

		// Start the scan and pull a few rows. The generator captures
		// `startLayer = pendingTransactionLayer ?? readLayer` when its body first
		// runs (i.e. on the first .next()), so we MUST pull at least one row
		// before the write to validate the documented capture-at-call-entry
		// snapshot behavior.
		const scan = table.query(fullScanFilter())[Symbol.asyncIterator]();
		const observed: Row[] = [];
		const PREFIX = 5;
		for (let i = 0; i < PREFIX; i++) {
			const { value, done } = await scan.next();
			expect(done).to.be.false;
			observed.push(value);
		}

		// Mutate the table inside an explicit transaction while the scan is live:
		// insert a brand-new key, update an existing not-yet-read row, and delete
		// an existing not-yet-read row. The first mutation lazily creates a fresh
		// TransactionLayer parented on the connection's readLayer, leaving the
		// scan's captured (now-parent) layer immutable.
		await table.begin();
		const NEW_KEY = 999;
		const ins = await table.update({ operation: 'insert', values: [NEW_KEY, -1] });
		expect(ins.status).to.equal('ok');
		const upd = await table.update({ operation: 'update', values: [10, 7777], oldKeyValues: [10] });
		expect(upd.status).to.equal('ok');
		const del = await table.update({ operation: 'delete', values: undefined, oldKeyValues: [15] });
		expect(del.status).to.equal('ok');

		// Drain the rest of the original scan.
		for (;;) {
			const { value, done } = await scan.next();
			if (done) break;
			observed.push(value);
		}

		// The in-flight scan must reflect its start-of-call snapshot: original
		// ROW_COUNT rows, untouched values, no leak of the insert/update/delete.
		expect(observed, 'snapshot cardinality unchanged').to.have.length(ROW_COUNT);
		expect(observed.some(r => r[0] === NEW_KEY), 'inserted key leaked into snapshot').to.be.false;
		expect(observed.find(r => r[0] === 10)?.[1], 'updated value leaked into snapshot').to.equal(20);
		expect(observed.some(r => r[0] === 15), 'deleted row vanished from snapshot').to.be.true;
		for (let r = 0; r < ROW_COUNT; r++) {
			expect(observed[r][0], `snapshot row ${r} id`).to.equal(r);
			expect(observed[r][1], `snapshot row ${r} v`).to.equal(r * 2);
		}

		// A scan started AFTER the writes (still inside the open transaction)
		// sees the pending layer — confirming the writes did land, and that the
		// snapshot isolation above was real rather than a no-op write.
		const postRows: Row[] = [];
		for await (const row of table.query(fullScanFilter())) {
			postRows.push(row);
		}
		// 20 original + 1 insert - 1 delete = 20.
		expect(postRows, 'post-write scan cardinality').to.have.length(ROW_COUNT);
		expect(postRows.some(r => r[0] === NEW_KEY), 'insert visible to new scan').to.be.true;
		expect(postRows.find(r => r[0] === 10)?.[1], 'update visible to new scan').to.equal(7777);
		expect(postRows.some(r => r[0] === 15), 'delete visible to new scan').to.be.false;

		await table.rollback();
	});

	it('materialized-view refresh (replaceBaseLayer) is atomic: in-flight scan keeps old, fresh scan sees new', async () => {
		// Models REFRESH MATERIALIZED VIEW at the vtab layer: the manager swaps in a
		// wholly new base layer while a reader is mid-scan. The in-flight reader,
		// having captured its snapshot at query entry, must observe fully-old state;
		// a fresh scan after the swap observes fully-new state — never half-state.
		const ROW_COUNT = 10;
		const table = await module.create(db, createTableSchema('refresh_atomic', module));
		await seed(table, ROW_COUNT); // rows [0,0],[1,2],...,[9,18]
		const manager = module.tables.get('main.refresh_atomic');
		expect(manager, 'backing manager registered').to.exist;

		// Start a scan and pull a prefix so it captures the pre-refresh base layer.
		const scan = table.query(fullScanFilter())[Symbol.asyncIterator]();
		const observed: Row[] = [];
		for (let i = 0; i < 3; i++) {
			const { value, done } = await scan.next();
			expect(done).to.be.false;
			observed.push(value);
		}

		// Refresh: atomically replace the base with a disjoint row set.
		const newRows: Row[] = [[100, 1000], [101, 1010], [102, 1020]];
		await manager!.replaceBaseLayer(newRows);

		// Drain the in-flight scan — it must still see the full pre-refresh snapshot.
		for (;;) {
			const { value, done } = await scan.next();
			if (done) break;
			observed.push(value);
		}
		expect(observed, 'in-flight scan keeps pre-refresh cardinality').to.have.length(ROW_COUNT);
		expect(observed.some(r => (r[0] as number) >= 100), 'refresh rows leaked into in-flight scan').to.be.false;

		// A scan started after the refresh sees only the new rows — fully-new.
		const fresh: Row[] = [];
		for await (const row of table.query(fullScanFilter())) {
			fresh.push(row);
		}
		expect(fresh.map(r => r[0])).to.deep.equal([100, 101, 102]);
	});

	it('overlapping scans started before a write each keep their own snapshot', async () => {
		const ROW_COUNT = 30;
		const table = await module.create(db, createTableSchema('overlap_snapshot', module));
		await seed(table, ROW_COUNT);

		// Two iterators, both advanced past their first .next() (capturing the
		// pre-write layer) BEFORE any mutation.
		const a = table.query(fullScanFilter())[Symbol.asyncIterator]();
		const b = table.query(fullScanFilter())[Symbol.asyncIterator]();
		const rowsA: Row[] = [];
		const rowsB: Row[] = [];
		rowsA.push((await a.next()).value);
		rowsB.push((await b.next()).value);

		// Intervening autocommit write (no explicit transaction).
		const ins = await table.update({ operation: 'insert', values: [500, 500] });
		expect(ins.status).to.equal('ok');

		// Continue draining both, still interleaved.
		let aDone = false;
		let bDone = false;
		while (!aDone || !bDone) {
			if (!aDone) {
				const { value, done } = await a.next();
				if (done) aDone = true; else rowsA.push(value);
			}
			if (!bDone) {
				const { value, done } = await b.next();
				if (done) bDone = true; else rowsB.push(value);
			}
		}

		// Neither in-flight scan sees the newly-inserted row.
		expect(rowsA, 'scan A cardinality').to.have.length(ROW_COUNT);
		expect(rowsB, 'scan B cardinality').to.have.length(ROW_COUNT);
		expect(rowsA.some(r => r[0] === 500), 'insert leaked into scan A').to.be.false;
		expect(rowsB.some(r => r[0] === 500), 'insert leaked into scan B').to.be.false;

		// A fresh scan after the autocommit insert does see it.
		const after: Row[] = [];
		for await (const row of table.query(fullScanFilter())) {
			after.push(row);
		}
		expect(after, 'post-insert scan cardinality').to.have.length(ROW_COUNT + 1);
		expect(after.some(r => r[0] === 500), 'insert visible to fresh scan').to.be.true;
	});
});
