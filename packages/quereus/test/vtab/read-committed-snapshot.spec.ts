import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { getModuleReadCommittedSnapshot } from '../../src/vtab/concurrency.js';
import { makeFullScanFilterInfo } from '../../src/vtab/filter-info.js';
import { encodeIdxStr, makeIdxStrSpec } from '../../src/vtab/idx-str.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { AnyVirtualTableModule } from '../../src/vtab/module.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { Row, SqlValue } from '../../src/common/types.js';

/**
 * `readCommittedSnapshot` is the module's declaration that a `_readCommitted`
 * connection serves a stable, self-consistent committed snapshot for the life of
 * the scan — the precondition for the engine running such a read outside the
 * execution mutex, concurrently with another statement's commit. Nothing in the
 * engine reads the flag yet; these tests pin the declaration itself and the
 * memory vtab's behaviour that justifies it.
 *
 * The memory cases drive `module.connect(... _readCommitted: true)` DIRECTLY
 * rather than through SQL: the engine still serializes every statement, so a
 * `committed.<table>` select could not have a commit land mid-iteration. Driving
 * the module means the reader's iterator is ours while the writer goes through
 * the engine normally — exactly the interleaving the concurrent path will create.
 */

/** A module object declaring (or omitting) the flag; the other methods are unused here. */
function makeStubModule(flag?: boolean): AnyVirtualTableModule {
	return ({ readCommittedSnapshot: flag } as unknown) as AnyVirtualTableModule;
}

/** FilterInfo for an unbounded walk of secondary index `indexName` (plan code 0 = scan). */
function indexScanFilterInfo(indexName: string, keyColumnIndex: number): FilterInfo {
	const base = makeFullScanFilterInfo();
	const idxStr = encodeIdxStr(makeIdxStrSpec(indexName, 'scan'));
	return {
		...base,
		idxStr,
		accessPath: {
			kind: 'index',
			plan: 'scan',
			index: {
				name: indexName,
				role: 'secondary',
				keyColumns: [{ columnIndex: keyColumnIndex, desc: false }],
				unique: false,
			},
		},
		indexInfoOutput: { ...base.indexInfoOutput, idxStr },
	};
}

async function collect(rows: AsyncIterable<Row>): Promise<Row[]> {
	const out: Row[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

/** Rows as `[id, v]` pairs sorted by id, so a comparison is order-independent. */
function normalize(rows: readonly Row[]): SqlValue[][] {
	return rows
		.map(r => [r[0], r[1]] as SqlValue[])
		.sort((a, b) => Number(a[0]) - Number(b[0]));
}

describe('committed-snapshot reads (readCommittedSnapshot)', () => {
	describe('getModuleReadCommittedSnapshot', () => {
		it('defaults to false when the module omits the flag', () => {
			expect(getModuleReadCommittedSnapshot(makeStubModule())).to.equal(false);
		});

		it('is false when explicitly declined', () => {
			expect(getModuleReadCommittedSnapshot(makeStubModule(false))).to.equal(false);
		});

		it('is true when declared', () => {
			expect(getModuleReadCommittedSnapshot(makeStubModule(true))).to.equal(true);
		});

		it('reports MemoryTableModule as snapshot-safe', () => {
			expect(getModuleReadCommittedSnapshot(new MemoryTableModule())).to.equal(true);
		});

		it('is orthogonal to concurrencyMode — a fully-reentrant module may still decline', () => {
			// The two answer different questions (per-connection reentrancy vs.
			// cross-connection tearing during a commit publish), so neither implies
			// the other. Pinning that here keeps a future refactor from folding the
			// flag into the enum.
			const fullyReentrant = ({
				concurrencyMode: 'fully-reentrant',
			} as unknown) as AnyVirtualTableModule;
			expect(getModuleReadCommittedSnapshot(fullyReentrant)).to.equal(false);
		});
	});

	describe('memory vtab honours the declaration', () => {
		let db: Database;
		let mod: MemoryTableModule;

		/** Opens a `_readCommitted` MemoryTable on `main.t`. */
		async function committedReader(): Promise<MemoryTable> {
			return await mod.connect(db, undefined, 'memsnap', 'main', 't', { _readCommitted: true });
		}

		beforeEach(async () => {
			db = new Database();
			mod = new MemoryTableModule();
			db.registerModule('memsnap', mod);
			await db.exec('create table t (id integer primary key, v text) using memsnap');
			await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
		});

		afterEach(async () => {
			await db.close();
		});

		it('serves the pre-commit row set to a scan a commit lands in the middle of', async () => {
			const reader = await committedReader();
			const iterator = reader.query(makeFullScanFilterInfo())[Symbol.asyncIterator]();

			// Pull one row so the scan has connected, pinned its read layer, and
			// captured the layer's BTree.
			const first = await iterator.next();
			expect(first.done, 'scan must yield at least one row before the commit').to.equal(false);

			// A full commit lands on another connection, mid-iteration.
			await db.exec("insert into t values (4, 'd')");
			await db.exec("delete from t where id = 1");

			const rest: Row[] = [];
			for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
				rest.push(step.value);
			}

			expect(normalize([first.value, ...rest]), 'iteration sees exactly the pre-commit rows')
				.to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c']]);

			await reader.disconnect();
		});

		it('gives a reader opened after the commit the post-commit row set', async () => {
			await db.exec("insert into t values (4, 'd')");
			await db.exec("delete from t where id = 1");

			const reader = await committedReader();
			const rows = await collect(reader.query(makeFullScanFilterInfo()));
			expect(normalize(rows)).to.deep.equal([[2, 'b'], [3, 'c'], [4, 'd']]);

			await reader.disconnect();
		});

		it('keeps an index-driven path and a full scan of one snapshot in agreement', async () => {
			await db.exec('create index t_v on t (v)');

			const reader = await committedReader();
			const indexIterator = reader.query(indexScanFilterInfo('t_v', 1))[Symbol.asyncIterator]();

			const first = await indexIterator.next();
			expect(first.done, 'index scan must yield at least one row before the commit').to.equal(false);

			// The commit publishes both a base row and its index entry; a module that
			// applied them in steps (or emptied the live index structure to rebuild it)
			// would let this scan miss rows the full scan below still sees.
			await db.exec("insert into t values (4, 'd')");
			await db.exec("delete from t where id = 1");

			const rest: Row[] = [];
			for (let step = await indexIterator.next(); !step.done; step = await indexIterator.next()) {
				rest.push(step.value);
			}
			const indexRows = normalize([first.value, ...rest]);

			// Same connection, same pinned snapshot, full-scan path.
			const scanRows = normalize(await collect(reader.query(makeFullScanFilterInfo())));

			expect(indexRows, 'index-driven result equals the full scan of the same snapshot')
				.to.deep.equal(scanRows);
			expect(indexRows).to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c']]);

			await reader.disconnect();
		});

		// The obligation bounds the snapshot at "some commit boundary at or before the
		// read began", and `ensureConnection` is lazy, so the pin lands on the first
		// pull rather than on `connect`. A commit in that window is therefore allowed
		// to be visible — pinned here so the laxer boundary is a decision, not a
		// surprise, if the pin ever moves earlier.
		it('pins at the first pull, not at connect', async () => {
			const reader = await committedReader();

			await db.exec("insert into t values (4, 'd')");

			expect(normalize(await collect(reader.query(makeFullScanFilterInfo()))))
				.to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);

			await reader.disconnect();
		});

		it('holds the snapshot across a concurrent DROP INDEX of the index being walked', async () => {
			await db.exec('create index t_v on t (v)');

			const reader = await committedReader();
			const iterator = reader.query(indexScanFilterInfo('t_v', 1))[Symbol.asyncIterator]();

			const first = await iterator.next();
			expect(first.done).to.equal(false);

			// Dropping the index a committed scan is mid-walk removes it from the
			// schema and from the base layer's index map. The walk holds its own
			// captured tree, so it must finish on the pre-drop entries rather than
			// truncate or throw "Secondary index not found".
			await db.exec('drop index t_v');

			const rest: Row[] = [];
			for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
				rest.push(step.value);
			}

			expect(normalize([first.value, ...rest]), 'snapshot survives the concurrent drop')
				.to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c']]);

			await reader.disconnect();
		});

		it('holds the snapshot across a concurrent DDL that rebuilds the table structures', async () => {
			await db.exec('create index t_v on t (v)');

			const reader = await committedReader();
			const iterator = reader.query(indexScanFilterInfo('t_v', 1))[Symbol.asyncIterator]();

			const first = await iterator.next();
			expect(first.done).to.equal(false);

			// ADD COLUMN rebuilds the base primary tree AND every secondary index.
			// The rebuild must REPLACE those structures, never empty the live ones in
			// place — otherwise this in-flight walk goes short. A stale-but-coherent
			// pre-DDL row shape is the documented outcome.
			await db.exec('alter table t add column w integer default 7');

			const rest: Row[] = [];
			for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
				rest.push(step.value);
			}

			expect(normalize([first.value, ...rest]), 'snapshot survives the concurrent rebuild')
				.to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c']]);

			await reader.disconnect();
		});

		it('does not join the writer transaction (the committed connection stays unregistered)', async () => {
			const before = db.getConnectionsForTable('main.t').length;

			const reader = await committedReader();
			await collect(reader.query(makeFullScanFilterInfo()));

			expect(db.getConnectionsForTable('main.t').length,
				'a _readCommitted connection must not be registered with the Database')
				.to.equal(before);

			await reader.disconnect();
		});

		it('refuses writes through a committed-snapshot connection', async () => {
			const reader = await committedReader();
			let err: unknown;
			try {
				await reader.update({ operation: 'insert', values: [9, 'z'] });
			} catch (e) {
				err = e;
			}
			expect(err, 'writing a committed snapshot must throw').to.be.instanceOf(Error);
			expect((err as Error).message).to.match(/committed-state snapshot/i);

			await reader.disconnect();
		});
	});
});
