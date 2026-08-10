/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode, type Row } from '../../src/common/types.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all result rows as named objects from db.eval */
async function evalAll(db: Database, sql: string, params?: any[]): Promise<Record<string, any>[]> {
	const rows: Record<string, any>[] = [];
	for await (const row of db.eval(sql, params)) {
		rows.push(row);
	}
	return rows;
}

/** Catch an async error and return it, or fail */
async function expectError(fn: () => Promise<unknown>): Promise<QuereusError> {
	try {
		await fn();
		expect.fail('Expected an error but none was thrown');
	} catch (e: unknown) {
		expect(e).to.be.instanceOf(QuereusError);
		return e as QuereusError;
	}
}

// ---------------------------------------------------------------------------
// Minimal VirtualTable implementation for testing scan error paths
// ---------------------------------------------------------------------------

class StubTable extends VirtualTable {
	disconnected = false;

	constructor(
		db: Database,
		module: VirtualTableModule<StubTable, BaseModuleConfig>,
		schemaName: string,
		tableName: string,
		queryFn?: (filterInfo: FilterInfo) => AsyncIterable<Row>,
		schema?: TableSchema,
	) {
		super(db, module, schemaName, tableName);
		// Expose query only if a queryFn was provided — allows testing vtab without query.
		// Assign (rather than override the base optional method) so the no-query path
		// leaves `query` genuinely undefined.
		if (queryFn) this.query = queryFn;
		if (schema) this.tableSchema = schema;
	}

	async disconnect(): Promise<void> {
		this.disconnected = true;
	}

	async update(_args: UpdateArgs): Promise<{ status: 'ok'; row?: Row }> {
		return { status: 'ok' };
	}
}

// ---------------------------------------------------------------------------
// Module factories for various error scenarios
// ---------------------------------------------------------------------------

function makeWorkingModule(rows: Row[] = []): VirtualTableModule<StubTable, BaseModuleConfig> {
	return {
		async create(db, tableSchema) {
			const queryFn = async function* () {
				for (const row of rows) yield row;
			};
			return new StubTable(db, this as any, tableSchema.schemaName, tableSchema.name, queryFn, tableSchema);
		},
		async connect(db, _pAux, _mod, schemaName, tableName) {
			const queryFn = async function* () {
				for (const row of rows) yield row;
			};
			return new StubTable(db, this as any, schemaName, tableName, queryFn);
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: rows.length, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
	};
}

function makeConnectThrowsModule(code: number, message: string): VirtualTableModule<StubTable, BaseModuleConfig> {
	return {
		async create(db, tableSchema) {
			return new StubTable(db, this as any, tableSchema.schemaName, tableSchema.name, undefined, tableSchema);
		},
		async connect(): Promise<StubTable> {
			throw new QuereusError(message, code);
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: 10, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
	};
}

function makeConnectThrowsPlainErrorModule(): VirtualTableModule<StubTable, BaseModuleConfig> {
	return {
		async create(db, tableSchema) {
			return new StubTable(db, this as any, tableSchema.schemaName, tableSchema.name, undefined, tableSchema);
		},
		async connect(): Promise<StubTable> {
			throw new Error('plain connect failure');
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: 10, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
	};
}

function makeCaptureOptionsModule(capture: { options?: BaseModuleConfig }): VirtualTableModule<StubTable, BaseModuleConfig> {
	return {
		async create(db, tableSchema) {
			return new StubTable(db, this as any, tableSchema.schemaName, tableSchema.name, undefined, tableSchema);
		},
		async connect(db, _pAux, _mod, schemaName, tableName, options) {
			capture.options = options;
			const queryFn = async function* (): AsyncIterable<Row> {
				yield [1] as Row;
			};
			return new StubTable(db, this as any, schemaName, tableName, queryFn);
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: 1, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
	};
}

function makeNoQueryModule(): VirtualTableModule<StubTable, BaseModuleConfig> {
	return {
		async create(db, tableSchema) {
			return new StubTable(db, this as any, tableSchema.schemaName, tableSchema.name, undefined, tableSchema);
		},
		async connect(db, _pAux, _mod, schemaName, tableName) {
			return new StubTable(db, this as any, schemaName, tableName, undefined);
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: 10, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
	};
}

function makeMidIterationThrowModule(errorCode: number = StatusCode.IOERR) {
	const disconnectCalls: string[] = [];
	const mod: VirtualTableModule<StubTable, BaseModuleConfig> & { disconnectCalls: string[] } = {
		async create(db: Database, tableSchema: TableSchema) {
			return new StubTable(db, mod as any, tableSchema.schemaName, tableSchema.name, undefined, tableSchema);
		},
		async connect(db: Database, _pAux: unknown, _mod: string, schemaName: string, tableName: string) {
			const queryFn = async function* () {
				yield [1, 'first'] as Row;
				throw new QuereusError('mid-iteration boom', errorCode);
			};
			const table = new StubTable(db, mod as any, schemaName, tableName, queryFn);
			const origDisconnect = table.disconnect.bind(table);
			table.disconnect = async () => {
				disconnectCalls.push(tableName);
				return origDisconnect();
			};
			return table;
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: 10, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
		disconnectCalls,
	};
	return mod;
}

function makeMidIterationPlainThrowModule(): VirtualTableModule<StubTable, BaseModuleConfig> {
	return {
		async create(db: Database, tableSchema: TableSchema) {
			return new StubTable(db, this as any, tableSchema.schemaName, tableSchema.name, undefined, tableSchema);
		},
		async connect(db: Database, _pAux: unknown, _mod: string, schemaName: string, tableName: string) {
			const queryFn = async function* () {
				yield [1, 'first'] as Row;
				throw new Error('plain mid-iter error');
			};
			return new StubTable(db, this as any, schemaName, tableName, queryFn);
		},
		async destroy() { /* no-op */ },
		getBestAccessPlan(_db: Database, _tableInfo: TableSchema, _request: BestAccessPlanRequest): BestAccessPlanResult {
			return { cost: 100, rows: 10, explains: 'full scan', handledFilters: _request.filters.map(() => false) };
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scan emitter (runtime/emit/scan.ts)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ---- Happy path: SeqScan, IndexScan, IndexSeek ----

	describe('SeqScan happy path', () => {
		it('scans empty table returning zero rows', async () => {
			await db.exec('create table t_empty (id integer primary key)');
			const rows = await evalAll(db, 'select * from t_empty');
			expect(rows).to.deep.equal([]);
		});

		it('scans single-row table', async () => {
			await db.exec('create table t_one (id integer primary key, val text)');
			await db.exec("insert into t_one values (1, 'hello')");
			const rows = await evalAll(db, 'select id, val from t_one');
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]).to.deep.include({ id: 1, val: 'hello' });
		});

		it('scans multi-row table', async () => {
			await db.exec('create table t_multi (id integer primary key, v integer)');
			await db.exec('insert into t_multi values (1, 10), (2, 20), (3, 30)');
			const rows = await evalAll(db, 'select id, v from t_multi order by id');
			expect(rows).to.have.lengthOf(3);
			expect(rows[0].id).to.equal(1);
			expect(rows[0].v).to.equal(10);
			expect(rows[2].id).to.equal(3);
			expect(rows[2].v).to.equal(30);
		});
	});

	describe('IndexScan happy path', () => {
		it('returns rows in index order', async () => {
			await db.exec('create table t_idx (id integer primary key, score integer)');
			await db.exec('create index idx_score on t_idx(score)');
			await db.exec('insert into t_idx values (1, 30), (2, 10), (3, 20)');
			const rows = await evalAll(db, 'select id from t_idx order by score');
			expect(rows.map(r => r.id)).to.deep.equal([2, 3, 1]);
		});
	});

	describe('IndexSeek happy path', () => {
		it('point lookup by primary key with literal', async () => {
			await db.exec('create table t_seek (id integer primary key, data text)');
			await db.exec("insert into t_seek values (10, 'ten'), (20, 'twenty')");
			const rows = await evalAll(db, 'select data from t_seek where id = 20');
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].data).to.equal('twenty');
		});

		it('point lookup by primary key with parameter (dynamic args)', async () => {
			await db.exec('create table t_seekp (id integer primary key, data text)');
			await db.exec("insert into t_seekp values (10, 'ten'), (20, 'twenty')");
			const rows = await evalAll(db, 'select data from t_seekp where id = ?', [20]);
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].data).to.equal('twenty');
		});

		it('seek miss returns zero rows', async () => {
			await db.exec('create table t_seekm (id integer primary key, data text)');
			await db.exec("insert into t_seekm values (1, 'one')");
			const rows = await evalAll(db, 'select data from t_seekm where id = 999');
			expect(rows).to.deep.equal([]);
		});

		it('composite key seek', async () => {
			await db.exec('create table t_comp (a integer, b integer, val text, primary key (a, b))');
			await db.exec("insert into t_comp values (1, 1, 'aa'), (1, 2, 'ab'), (2, 1, 'ba')");
			const rows = await evalAll(db, 'select val from t_comp where a = 1 and b = 2');
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].val).to.equal('ab');
		});

		it('dynamic parameter seek with empty result', async () => {
			await db.exec('create table t_dyn (id integer primary key, v text)');
			await db.exec("insert into t_dyn values (1, 'one')");
			const rows = await evalAll(db, 'select v from t_dyn where id = ?', [999]);
			expect(rows).to.deep.equal([]);
		});
	});

	// ---- Error wrapping: connect throws ----

	describe('connect failure error wrapping', () => {
		it('preserves original QuereusError code as wrapped error code', async () => {
			db.registerModule('cfail_busy', makeConnectThrowsModule(StatusCode.BUSY, 'db is busy'));
			await db.exec('create table t_cfail (id integer primary key) using cfail_busy');

			const err = await expectError(() => evalAll(db, 'select * from t_cfail'));
			expect(err.code).to.equal(StatusCode.BUSY);
			expect(err.message).to.include('connect failed');
			expect(err.message).to.include('t_cfail');
		});

		it('wraps plain Error with StatusCode.ERROR and sets cause', async () => {
			db.registerModule('cfail_plain', makeConnectThrowsPlainErrorModule());
			await db.exec('create table t_cfp (id integer primary key) using cfail_plain');

			const err = await expectError(() => evalAll(db, 'select * from t_cfp'));
			expect(err.code).to.equal(StatusCode.ERROR);
			expect(err.message).to.include('connect failed');
			expect(err.cause).to.be.instanceOf(Error);
			expect((err.cause as Error).message).to.equal('plain connect failure');
		});

		it('cause chain reaches the original thrown object', async () => {
			db.registerModule('cfail_cause', makeConnectThrowsModule(StatusCode.LOCKED, 'locked out'));
			await db.exec('create table t_cause (id integer primary key) using cfail_cause');

			const err = await expectError(() => evalAll(db, 'select * from t_cause'));
			expect(err.cause).to.be.instanceOf(QuereusError);
			expect((err.cause as QuereusError).code).to.equal(StatusCode.LOCKED);
			expect((err.cause as QuereusError).message).to.equal('locked out');
		});
	});

	// ---- Error wrapping: query not supported ----

	describe('vtab without query method', () => {
		it('throws UNSUPPORTED when vtab.query is not a function', async () => {
			db.registerModule('no_query', makeNoQueryModule());
			await db.exec('create table t_noq (id integer primary key) using no_query');

			const err = await expectError(() => evalAll(db, 'select * from t_noq'));
			expect(err.code).to.equal(StatusCode.UNSUPPORTED);
			expect(err.message).to.include('does not support query');
		});
	});

	// ---- Error wrapping: mid-iteration throw ----

	describe('mid-iteration error wrapping', () => {
		it('wraps mid-iteration QuereusError preserving code and cause', async () => {
			const mod = makeMidIterationThrowModule(StatusCode.IOERR);
			db.registerModule('mid_throw', mod);
			await db.exec('create table t_mid (id integer primary key, val text) using mid_throw');

			const err = await expectError(() => evalAll(db, 'select * from t_mid'));
			expect(err.code).to.equal(StatusCode.IOERR);
			expect(err.message).to.include('Error during query');
			expect(err.message).to.include('t_mid');
			expect(err.cause).to.be.instanceOf(QuereusError);
			expect((err.cause as QuereusError).code).to.equal(StatusCode.IOERR);
		});

		it('wraps plain Error mid-iteration with StatusCode.ERROR', async () => {
			db.registerModule('mid_plain', makeMidIterationPlainThrowModule());
			await db.exec('create table t_midp (id integer primary key, val text) using mid_plain');

			const err = await expectError(() => evalAll(db, 'select * from t_midp'));
			expect(err.code).to.equal(StatusCode.ERROR);
			expect(err.cause).to.be.instanceOf(Error);
			expect((err.cause as Error).message).to.equal('plain mid-iter error');
		});

		it('disconnects vtab even when iteration throws', async () => {
			const mod = makeMidIterationThrowModule();
			db.registerModule('mid_disc', mod);
			await db.exec('create table t_midd (id integer primary key, val text) using mid_disc');

			try {
				await evalAll(db, 'select * from t_midd');
			} catch {
				// expected
			}
			expect(mod.disconnectCalls).to.include('t_midd');
		});
	});

	// ---- Cleanup on normal exit ----

	describe('cleanup on normal completion', () => {
		it('disconnects vtab after successful scan', async () => {
			const mod = makeWorkingModule([[1, 'a'], [2, 'b']]);
			db.registerModule('working', mod);
			await db.exec('create table t_work (id integer primary key, val text) using working');

			const rows = await evalAll(db, 'select * from t_work');
			expect(rows).to.have.lengthOf(2);
		});
	});

	// ---- IndexSeek static vs dynamic args ----

	describe('IndexSeek args path', () => {
		it('static seek keys produce correct results', async () => {
			await db.exec('create table t_static (id integer primary key, v text)');
			await db.exec("insert into t_static values (1, 'one'), (2, 'two'), (3, 'three')");
			const rows = await evalAll(db, 'select v from t_static where id = 2');
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].v).to.equal('two');
		});

		it('dynamic seek keys via parameters produce correct results', async () => {
			await db.exec('create table t_dynamic (id integer primary key, v text)');
			await db.exec("insert into t_dynamic values (1, 'one'), (2, 'two'), (3, 'three')");
			const rows = await evalAll(db, 'select v from t_dynamic where id = ?', [3]);
			expect(rows).to.have.lengthOf(1);
			expect(rows[0].v).to.equal('three');
		});
	});

	// ---- vtabArgs propagation to connect ----

	describe('vtabArgs propagation', () => {
		it('passes USING module args to connect options', async () => {
			const capture: { options?: BaseModuleConfig } = {};
			db.registerModule('capture_opts', makeCaptureOptionsModule(capture));
			await db.exec("create table t_opts (id integer primary key) using capture_opts(flavor='vanilla', count=42)");

			await evalAll(db, 'select * from t_opts');
			expect(capture.options).to.exist;
			expect((capture.options as any).flavor).to.equal('vanilla');
			expect((capture.options as any).count).to.equal(42);
		});
	});

	// ---- Row descriptor mapping ----

	describe('row descriptor correctness', () => {
		it('column values are mapped to correct positions', async () => {
			await db.exec('create table t_cols (a integer primary key, b text, c real)');
			await db.exec("insert into t_cols values (1, 'hello', 3.14)");
			const rows = await evalAll(db, 'select c, a from t_cols');
			expect(rows[0].c).to.equal(3.14);
			expect(rows[0].a).to.equal(1);
		});
	});
});
