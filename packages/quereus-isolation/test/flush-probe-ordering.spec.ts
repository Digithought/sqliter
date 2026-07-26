import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, QuereusError, StatusCode, asyncIterableToArray } from '@quereus/quereus';
import type { FilterInfo, RowOp, SqlValue, UpdateArgs } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * Pins the commit flush's read/write ordering invariant:
 *
 * **The flush must not read an underlying table after it has begun writing that
 * table.** An underlying module is not obliged to serve reads — least of all
 * index-driven ones — over its own uncommitted writes. So every insert-vs-update
 * probe (`rowExistsInUnderlying`, a full-PK point lookup driving the underlying's
 * primary index) has to be resolved BEFORE the first write of that flush lands.
 *
 * The regression this guards: the probes used to run inline in the write loop, so
 * row 1's insert staged a draft and row 2's probe read straight into it. Lamina's
 * `StagedCollection.scan` deliberately REFUSES a compound-index driver while the
 * write batch holds staged drafts (compound-index entries are only authored when
 * the batch resolves, so an index walk over staged state would be silently stale),
 * which failed every transaction writing 2+ rows into one compound-PK table.
 *
 * The default `MemoryTableModule` serves its own staged reads happily and so
 * cannot reproduce that, but it does not need to: the invariant is stated directly
 * here by an underlying whose `query()` throws once its `update()` has been called.
 * That is strictly stronger than reproducing lamina's particular refusal — any
 * underlying with any read restriction over its own pending writes is covered.
 */

type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

/** `after-first-write` states the invariant; `always` is the harness's own control. */
type ReadPolicy = 'after-first-write' | 'always';

type FlushOp =
	| { kind: 'read' }
	| { kind: 'write'; operation: RowOp; pk: SqlValue[] };

/**
 * A memory module whose tables refuse reads once armed, recording the read/write
 * sequence they see. Refusal is OFF until a test arms it, so schema setup and the
 * transaction's own DML (which legitimately reads the underlying) run untouched;
 * arming immediately before `COMMIT` scopes the barrier to the flush.
 *
 * Refusal is tracked per table NAME, matching the invariant's scope: a multi-table
 * commit may read table B after writing table A.
 */
class ReadRefusingMemoryModule extends MemoryTableModule {
	private policy: ReadPolicy | null = null;
	private readonly written = new Set<string>();
	/** Read/write sequence observed while armed, in consumption order. */
	readonly ops: FlushOp[] = [];
	/** Column indices of the PK, in PK order — decodes an insert's row into its key. */
	pkIndices: number[] = [];

	arm(policy: ReadPolicy): void {
		this.policy = policy;
		this.written.clear();
		this.ops.length = 0;
	}

	disarm(): void {
		this.policy = null;
	}

	private onRead(tableName: string): void {
		if (this.policy === null) return;
		if (this.policy === 'always' || this.written.has(tableName)) {
			throw new QuereusError(
				`underlying '${tableName}' refuses a read over its own uncommitted writes`,
				StatusCode.INTERNAL,
			);
		}
		this.ops.push({ kind: 'read' });
	}

	private onWrite(tableName: string, args: UpdateArgs): void {
		if (this.policy === null) return;
		this.written.add(tableName);
		const pk = args.operation === 'insert'
			? this.pkIndices.map(i => (args.values ?? [])[i])
			: [...(args.oldKeyValues ?? [])];
		this.ops.push({ kind: 'write', operation: args.operation, pk });
	}

	private wrap(table: UnderlyingTable): UnderlyingTable {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const module = this;
		return new Proxy(table, {
			get(target, prop) {
				if (prop === 'query') {
					// Recorded/refused at CONSUMPTION, so the log is true call order.
					return async function* (filterInfo: FilterInfo) {
						module.onRead(target.tableName);
						yield* target.query!(filterInfo);
					};
				}
				if (prop === 'update') {
					return (args: UpdateArgs) => {
						module.onWrite(target.tableName, args);
						return target.update(args);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
		return this.wrap(await super.create(...args));
	}

	override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
		return this.wrap(await super.connect(...args));
	}
}

describe('commit flush — probes resolve before any write', () => {
	let underlying: ReadRefusingMemoryModule;
	let db: Database;

	beforeEach(async () => {
		underlying = new ReadRefusingMemoryModule();
		underlying.pkIndices = [0, 1];
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying }));
		// Compound PK: the shape lamina's index-driver refusal fires on, and the shape
		// whose probe cannot be answered from the row's own values.
		await db.exec('create table t (a integer, b integer, v text, primary key (a, b)) using isolated');
		await db.exec(`insert into t values (1, 1, 'seed-1-1')`);
		await db.exec(`insert into t values (1, 2, 'seed-1-2')`);
	});

	afterEach(async () => {
		underlying.disarm();
		await db.close();
	});

	/** Stages one row of every flush shape: update, delete, and two fresh inserts. */
	async function stageMixedTransaction(): Promise<void> {
		await db.exec('begin');
		await db.exec(`insert into t values (2, 1, 'new-2-1')`);
		await db.exec(`insert into t values (2, 2, 'new-2-2')`);
		await db.exec(`update t set v = 'mod-1-1' where a = 1 and b = 1`);
		await db.exec('delete from t where a = 1 and b = 2');
	}

	async function rows(): Promise<SqlValue[][]> {
		const out = await asyncIterableToArray(db.eval('select a, b, v from t order by a, b'));
		return out.map((r: any) => [r.a, r.b, r.v]);
	}

	it('commits a multi-row compound-PK write against an underlying that refuses reads after its first write', async () => {
		await stageMixedTransaction();
		underlying.arm('after-first-write');

		await db.exec('commit');
		underlying.disarm();

		expect(await rows()).to.deep.equal([
			[1, 1, 'mod-1-1'],
			[2, 1, 'new-2-1'],
			[2, 2, 'new-2-2'],
		]);
	});

	it('resolves every probe before the first write, and classifies insert vs update correctly', async () => {
		await stageMixedTransaction();
		underlying.arm('after-first-write');
		await db.exec('commit');
		underlying.disarm();

		const kinds = underlying.ops.map(op => op.kind);
		const firstWrite = kinds.indexOf('write');
		expect(firstWrite, 'the flush wrote something').to.be.greaterThan(-1);
		expect(kinds.lastIndexOf('read'), 'every read precedes every write').to.be.lessThan(firstWrite);

		// One probe per LIVE row; a tombstone needs no insert-vs-update answer.
		expect(kinds.slice(0, firstWrite), 'one probe per live overlay row').to.deep.equal(['read', 'read', 'read']);

		// Sorted by PK so the assertion states the classification, not the flush's
		// tombstones-first write order (covered elsewhere).
		const writes = underlying.ops
			.filter((op): op is Extract<FlushOp, { kind: 'write' }> => op.kind === 'write')
			.map(op => [op.operation, ...op.pk])
			.sort((x, y) => Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]));
		expect(writes).to.deep.equal([
			['update', 1, 1],   // pre-existing PK → update
			['delete', 1, 2],   // tombstone
			['insert', 2, 1],   // fresh PK → insert
			['insert', 2, 2],
		]);
	});

	it('control: the barrier reaches the flush — an underlying refusing ALL reads aborts the commit', async () => {
		// Proves the probes really run through this proxy (and that a refused probe is
		// fatal), so the first two tests are not vacuously green.
		await stageMixedTransaction();
		underlying.arm('always');

		let threw = false;
		try {
			await db.exec('commit');
		} catch {
			threw = true;
		}
		underlying.disarm();

		expect(threw, 'a refused probe must abort the commit').to.be.true;
		expect(await rows(), 'the aborted commit leaves the committed base intact').to.deep.equal([
			[1, 1, 'seed-1-1'],
			[1, 2, 'seed-1-2'],
		]);
	});
});
